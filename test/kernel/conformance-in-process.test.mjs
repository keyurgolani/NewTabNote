// #13's conformance suite (messaging-conformance.mjs) over the in-process transport, as the
// worker's own code, tests, and the PiP editor reach the router (#13, "Topology")

import { createInProcessTransport } from '../../js/kernel/core/messaging/in-process.js';
import { describeConformance } from './messaging-conformance.mjs';

describeConformance('in-process', router => ({
  transport: surface => createInProcessTransport({ router, surface }),
  // The worker stopping closes every connection to its router
  stop: () => router.close(),
}));
