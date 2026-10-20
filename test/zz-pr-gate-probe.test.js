const test = require('node:test');
const assert = require('node:assert/strict');

// Temporary probe for pr-gate's failure reporting. Reverted in the next commit.
test('pr-gate probe fails on purpose', () => {
  assert.equal('probe', 'reverted next');
});
