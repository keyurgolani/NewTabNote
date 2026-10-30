// #13's conformance suite (messaging-conformance.mjs) over the runtime port, on the Chrome
// fake: the worker installs the router at its top level, each client is a page of its own,
// and the coordinator going away is the worker stopping (#13, "Topology")

import { createRuntimePortTransport, installRuntimePort } from '../../js/kernel/adapters/messaging/runtime-port.js';
import { createChromeFake } from './chrome-fake.mjs';
import { describeConformance } from './messaging-conformance.mjs';

describeConformance('runtime-port', router => {
  const fake = createChromeFake();
  fake.worker.install(chrome => installRuntimePort({ runtime: chrome.runtime, router }));
  return {
    transport: surface =>
      createRuntimePortTransport({
        runtime: fake.page(/** @type {'newtab' | 'popup' | 'sidepanel' | 'offscreen'} */ (surface)).chrome.runtime,
      }),
    stop: () => fake.worker.stop(),
  };
});
