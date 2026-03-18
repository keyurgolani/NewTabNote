const test = require('node:test');
const assert = require('node:assert/strict');

const { calculatePanelWidth } = require('../js/resizable-panel.js');

test('calculatePanelWidth grows right-anchored panels with positive mouse movement', () => {
  const width = calculatePanelWidth({
    startWidth: 260,
    startX: 100,
    currentX: 160,
    min: 180,
    max: 500,
    direction: 'right',
  });

  assert.equal(width, 320);
});

test('calculatePanelWidth grows left-anchored panels when dragging left', () => {
  const width = calculatePanelWidth({
    startWidth: 360,
    startX: 500,
    currentX: 420,
    min: 280,
    max: 600,
    direction: 'left',
  });

  assert.equal(width, 440);
});

test('calculatePanelWidth clamps to min and max bounds', () => {
  assert.equal(calculatePanelWidth({
    startWidth: 260,
    startX: 100,
    currentX: -1000,
    min: 180,
    max: 500,
    direction: 'right',
  }), 180);

  assert.equal(calculatePanelWidth({
    startWidth: 360,
    startX: 500,
    currentX: -1000,
    min: 280,
    max: 600,
    direction: 'left',
  }), 600);
});
