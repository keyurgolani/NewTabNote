'use strict';

// The formatting toolbar's pane (#14). Each editor passes its pane as its toolbar's root, so a
// selection shows that pane's toolbar alone. A toolbar given no root takes the document, so it
// shows for a selection in any block, as every toolbar did before.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv } = require('./helpers/legacy-env');

/** A page with the toolbar's code and two panes of one block each, where `select` makes a selection in a pane's block by hand */
function page() {
  const env = createLegacyEnv();
  const doc = env.document;
  env.global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  env.global.scrollX = 0;
  env.global.scrollY = 0;
  env.window.innerWidth = 1440;
  // A document holds every node in it, as Node.contains reads it
  doc.contains = node => doc.documentElement.contains(node);
  const panes = {};
  for (const id of ['editor-container', 'secondary-editor-container']) {
    const pane = doc.body.appendChild(doc.createElement('div'));
    pane.id = id;
    const content = pane.appendChild(doc.createElement('div'));
    content.className = 'block-content';
    content.nodeType = 1;
    panes[id] = { pane, content };
  }
  let selected = null;
  env.window.getSelection = () => selected && {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: selected,
    getRangeAt: () => ({
      commonAncestorContainer: selected,
      getBoundingClientRect: () => ({ top: 200, bottom: 218, left: 300, right: 340, width: 40, height: 18 }),
    }),
  };
  env.load('js/ui/formatting-toolbar.js');
  return {
    doc,
    panes,
    FormattingToolbar: env.get('FormattingToolbar'),
    /** Select in the block of the pane with this id, and fire the document's selectionchange */
    select(id) {
      selected = panes[id].content;
      doc.fire('selectionchange');
    },
  };
}

describe("the formatting toolbar's pane (#14)", () => {
  it('a toolbar built with no root shows for a selection in any block, in either pane', () => {
    const { doc, FormattingToolbar, select } = page();
    const toolbar = new FormattingToolbar({ doc });
    for (const id of ['editor-container', 'secondary-editor-container']) {
      toolbar.hide();
      select(id);
      assert.equal(toolbar.visible, true, `it shows for a selection in #${id}`);
      assert.equal(toolbar.el.classList.contains('visible'), true, `it's drawn for a selection in #${id}`);
    }
  });

  it("a toolbar given its pane as its root shows only for a selection in that pane's blocks", () => {
    const { doc, panes, FormattingToolbar, select } = page();
    const toolbar = new FormattingToolbar({ doc, root: panes['editor-container'].pane });
    select('editor-container');
    assert.equal(toolbar.visible, true, 'it shows for a selection in its pane');
    select('secondary-editor-container');
    assert.equal(toolbar.visible, false, 'it hides for one in the other pane');
  });
});
