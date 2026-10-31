/**
 * The new tab's boot root (#27 slice 3, "Entries"): the one module newtab.html loads, after
 * the classic boot guard (js/entries/boot-guard.js). It holds ntn-boot while the tab starts and
 * loads the workspace chunk, today's whole new tab, through the page's loader
 * (js/entries/boot.js). Until #2 builds the moment chunk, the workspace is the tab.
 */

import { pageLoader } from '../runtime/lazy.js';
import { bootWorkspace, holdBootLock, whenInteractionReady } from './boot.js';

holdBootLock({ locks: navigator.locks, whenReady: whenInteractionReady, setTimeout, clearTimeout });
bootWorkspace({ loader: pageLoader(), target: window, load: () => import('../workspace.js') });
