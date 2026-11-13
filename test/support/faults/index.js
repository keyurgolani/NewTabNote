'use strict';

/**
 * The faults and probes #28's slice 4 names, for tests on either host (#301): the IndexedDB request
 * counter (idb-requests.js), and the hung-repository fault, as the store hold (store-hold.js) and a
 * hung port (hang-calls.js). The fault wrapper, storage-faults.mjs, is an ES module, which the
 * kernel tests import by its own path. Nothing under test/support/ ships.
 */

module.exports = { ...require('./idb-requests'), ...require('./store-hold'), ...require('./hang-calls') };
