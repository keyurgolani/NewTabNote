'use strict';

/**
 * The new tab's block projections (#14 slice 1), as js/kernel/composition/block-projections.js
 * sets them before the legacy scripts run. Requiring this file sets `BlockProjections` on
 * Node's global too, for the tests that require a legacy script straight from js/, since those
 * scripts read it there. test/helpers/legacy-env.js gives each environment the same object.
 */

let projections = null;

/** The projections of the built-ins' catalog, as the new tab's bridge makes them, made once */
function newTabBlockProjections() {
  if (!projections) {
    const { builtInCatalog, pageReaders } = require('../../js/kernel/core/blocks/index.js');
    projections = pageReaders(builtInCatalog());
  }
  return projections;
}

globalThis.BlockProjections = newTabBlockProjections();
// The trusted-rendering port the new tab installs beside them (#14 slice 2)
require('./block-rendering');

module.exports = { newTabBlockProjections };
