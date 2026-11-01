'use strict';

/**
 * The new tab's trusted-rendering port (#14 slice 2), as js/kernel/composition/rendering.js
 * sets it before the legacy scripts run. Requiring this file sets `BlockRendering` on Node's
 * global too, for the tests that require a legacy script straight from js/.
 * test/helpers/legacy-env.js gives each environment the same object.
 */

let rendering = null;

/** The port the new tab's composition installs, made once */
function newTabBlockRendering() {
  if (!rendering) {
    const { legacyRendering } = require('../../js/kernel/adapters/rendering/legacy.js');
    rendering = legacyRendering();
  }
  return rendering;
}

globalThis.BlockRendering = newTabBlockRendering();

module.exports = { newTabBlockRendering };
