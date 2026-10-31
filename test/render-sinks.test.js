'use strict';

// #14 slice 2: the rendering boundary. Block code puts rich text into the DOM only through the
// trusted-rendering port, and security/render-sinks.json lists every other raw markup sink it
// may have, each with its count and the issue that removes it. A sink no row covers, a count
// that changed, and a row whose sink is gone all fail.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { markupSinks, scanSource, scopeFiles, ledgerProblems } = require('./helpers/sink-scan');
const { createLegacyEnv } = require('./helpers/legacy-env');

const ROOT = path.join(__dirname, '..');
const LEDGER = 'security/render-sinks.json';
const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

describe('the render-sink ledger (security/render-sinks.json)', () => {
  it('covers every raw markup sink in block code, each count as it is, and no sink that is gone', () => {
    const ledger = read(LEDGER);
    assert.deepEqual(ledgerProblems(markupSinks(ledger.scope), ledger), []);
  });

  it('scans the block code that exists, the port included', () => {
    const files = scopeFiles(read(LEDGER).scope);
    for (const file of ['js/blocks.js', 'js/editor.js', 'js/ui/formatting-toolbar.js', 'js/kernel/adapters/rendering/legacy.js']) {
      assert.ok(files.includes(file), file);
    }
  });

  it('allows a dynamic sink only in the port and for the packaged picker icons', () => {
    const dynamic = read(LEDGER).sinks.filter(row => row.kind === 'dynamic').map(row => `${row.file}#${row.function}`);
    assert.deepEqual(dynamic.sort(), ['js/editor.js#_pickerItem', 'js/kernel/adapters/rendering/legacy.js#render']);
  });

  it('fails on a new raw sink in any block code file', () => {
    const ledger = read(LEDGER);
    for (const file of ['js/blocks.js', 'js/editor.js', 'js/ui/formatting-toolbar.js']) {
      const text = `${fs.readFileSync(path.join(ROOT, file), 'utf8')}\nfunction added(el, html) { el.innerHTML = html; }\n`;
      const problems = ledgerProblems(markupSinks(ledger.scope, { texts: { [file]: text } }), ledger);
      assert.deepEqual(problems.map(problem => problem.split(':')[0]), [`${file}#added#dynamic`], file);
    }
  });

  it('gives each row a known kind, a count, an owner, and what removes it', () => {
    for (const row of read(LEDGER).sinks) {
      const name = `${row.file}#${row.function}`;
      assert.ok(row.kind === 'static' || row.kind === 'dynamic', name);
      assert.ok(Number.isSafeInteger(row.count) && row.count > 0, name);
      assert.ok(Number.isSafeInteger(row.owner) && row.owner > 0, name);
      assert.ok(typeof row.removeWhen === 'string' && row.removeWhen !== '', name);
    }
  });

  it('finds each kind of sink, in the function it is in, and never one in a comment, a string, or a clear', () => {
    const found = scanSource(`
      // el.innerHTML = html in a comment
      const text = "el.innerHTML = html";
      function render(el, html) { el.innerHTML = html; }
      class View { add(el) { el.innerHTML += '<hr>'; } clear(el) { el.innerHTML = ''; } }
      const swap = (el, html) => { el.outerHTML = \`<p>\${html}</p>\`; };
      const icon = { set: el => { el.innerHTML = \`<svg></svg>\`; } };
      function after(el, html) { el.insertAdjacentHTML('beforeend', html); }
      function frame(el, html) { el.srcdoc = html; }
      function paste(doc, html) { doc.execCommand('insertHTML', false, html); doc.execCommand('bold'); }
      function old(html) { document.write(html); }
    `);
    assert.deepEqual(found.map(({ sink, kind, function: name }) => [sink, kind, name]), [
      ['innerHTML', 'dynamic', 'render'],
      ['innerHTML', 'static', 'add'],
      ['outerHTML', 'dynamic', 'swap'],
      ['innerHTML', 'static', 'set'],
      ['insertAdjacentHTML', 'dynamic', 'after'],
      ['srcdoc', 'dynamic', 'frame'],
      ['execCommand insertHTML', 'dynamic', 'paste'],
      ['document.write', 'dynamic', 'old'],
    ]);
  });

  it('finds an assignment however the member is named and whatever assigns it', () => {
    const found = scanSource(`
      function keyed(el, html) { el['innerHTML'] = html; }
      function orElse(el, html) { el.innerHTML ||= html; }
      function nullish(el, html) { el.outerHTML ??= html; }
      function andAlso(el, html) { el.srcdoc &&= html; }
      function wrapped(el, html) { (el.innerHTML) = html; (el)['innerHTML'] += '<hr>'; }
      function cleared(el) { el['innerHTML'] = ''; el.innerHTML ||= ''; }
    `);
    assert.deepEqual(found.map(({ sink, kind, function: name }) => [sink, kind, name]), [
      ['innerHTML', 'dynamic', 'keyed'],
      ['innerHTML', 'dynamic', 'orElse'],
      ['outerHTML', 'dynamic', 'nullish'],
      ['srcdoc', 'dynamic', 'andAlso'],
      ['innerHTML', 'dynamic', 'wrapped'],
      ['innerHTML', 'static', 'wrapped'],
    ]);
  });

  it('finds an assignment through Object.assign and Reflect.set', () => {
    const found = scanSource(`
      function assigned(el, innerHTML) { Object.assign(el, { innerHTML }); }
      function assignedMany(el, html) { Object.assign(el, { id: 'x' }, { 'outerHTML': html, srcdoc: '<p></p>' }); }
      function reflected(el, html) { Reflect.set(el, 'innerHTML', html); }
      function neither(el, data) { Object.assign(el, { id: data }); Reflect.set(el, 'id', data); Object.assign(el, { innerHTML: '' }); }
    `);
    assert.deepEqual(found.map(({ sink, kind, function: name }) => [sink, kind, name]), [
      ['Object.assign innerHTML', 'dynamic', 'assigned'],
      ['Object.assign outerHTML', 'dynamic', 'assignedMany'],
      ['Object.assign srcdoc', 'static', 'assignedMany'],
      ['Reflect.set innerHTML', 'dynamic', 'reflected'],
    ]);
  });

  it("finds a call however the method is named, and a document's write on any receiver named for one", () => {
    const found = scanSource(`
      function keyed(el, html) { el['insertAdjacentHTML']('beforeend', html); (el).setHTMLUnsafe(html); }
      function local(doc, html) { doc.write(html); }
      class Frame { fill(html) { this.doc.writeln(html); this.frame.contentDocument['write'](html); } }
      function stream(out, html) { out.write(html); navigator.clipboard.write([html]); }
    `);
    assert.deepEqual(found.map(({ sink, kind, function: name }) => [sink, kind, name]), [
      ['insertAdjacentHTML', 'dynamic', 'keyed'],
      ['setHTMLUnsafe', 'dynamic', 'keyed'],
      ['document.write', 'dynamic', 'local'],
      ['document.writeln', 'dynamic', 'fill'],
      ['document.write', 'dynamic', 'fill'],
    ]);
  });

  it('finds execCommand with a command that is not a literal, unless it is given no value', () => {
    const found = scanSource(`
      function any(doc, command, html) { doc.execCommand(command, false, html); }
      function keyed(doc, html) { doc['execCommand'](\`insert\${'HTML'}\`, false, html); }
      function formats(doc, command) { doc.execCommand(command, false, null); doc.execCommand(command); doc.execCommand(command, false, undefined); }
    `);
    assert.deepEqual(found.map(({ sink, kind, function: name }) => [sink, kind, name]), [
      ['execCommand', 'dynamic', 'any'],
      ['execCommand', 'dynamic', 'keyed'],
    ]);
  });

  it('finds markup parsed into nodes the page can adopt', () => {
    const found = scanSource(`
      function parsed(el, html) { el.append(...new DOMParser().parseFromString(html, 'text/html').body.childNodes); }
      function unsafe(el, html) { el.replaceChildren(Document.parseHTMLUnsafe(html).body); }
      function packaged(parser) { return parser.parseFromString('<svg></svg>', 'image/svg+xml'); }
    `);
    assert.deepEqual(found.map(({ sink, kind, function: name }) => [sink, kind, name]), [
      ['parseFromString', 'dynamic', 'parsed'],
      ['parseHTMLUnsafe', 'dynamic', 'unsafe'],
      ['parseFromString', 'static', 'packaged'],
    ]);
  });
});

describe('blocks render their rich text through the port (#14 slice 2)', () => {
  /**
   * The elements and markup `Block#createElement` hands the port for a block
   * @param {Record<string, unknown>} fields
   */
  const rendered = fields => {
    const env = createLegacyEnv();
    // The fake DOM's styles are plain objects; createElement sets one custom property
    const make = env.document.createElement.bind(env.document);
    env.document.createElement = tag => {
      const el = make(tag);
      el.style.setProperty = (name, value) => { el.style[name] = value; };
      return el;
    };
    const calls = [];
    const port = env.global.BlockRendering;
    env.global.BlockRendering = {
      ...port,
      render(el, richText) {
        calls.push([el.className, richText]);
        port.render(el, richText);
      },
    };
    env.load('js/utils.js', 'js/blocks.js');
    const Block = env.get('Block');
    new Block(fields).createElement();
    return calls;
  };

  it("renders a text block's content, and every type that shows content the same way", () => {
    for (const type of ['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'quote', 'code', 'callout']) {
      assert.deepEqual(rendered({ type, content: '<b>x</b>' }), [['block-content', '<b>x</b>']], type);
    }
  });

  it("renders a toggle's content and its children", () => {
    assert.deepEqual(rendered({ type: 'toggle', content: '<i>t</i>', children: 'c<br>d' }), [
      ['block-content', '<i>t</i>'],
      ['toggle-children-content', 'c<br>d'],
    ]);
  });

  it('renders nothing through it for the types whose fields are plain text', () => {
    for (const type of ['divider', 'image', 'table', 'bookmark', 'video', 'file', 'equation']) {
      assert.deepEqual(rendered({ type, content: '<b>x</b>' }), [], type);
    }
  });
});
