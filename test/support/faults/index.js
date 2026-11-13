'use strict';

/**
 * The faults and probes #28's slice 4 names, for tests on either host (#301): the IndexedDB request
 * counter (idb-requests.js). Nothing under test/support/ ships.
 */

module.exports = { ...require('./idb-requests') };
