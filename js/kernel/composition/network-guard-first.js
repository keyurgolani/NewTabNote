/**
 * The network guard, installed on this context as this module loads (#21 slice 1b, "Guard"):
 * the first import of the service worker (js/background.js) and of the indexer
 * (js/workers/indexer.js), and what each page's first script, js/network-guard.js, runs. The
 * build checks it comes first in each (scripts/build/guard.js). Its imports touch no browser
 * API, and installContextGuard never throws.
 */

import { installContextGuard } from './network-guard-install.js';

installContextGuard(globalThis);
