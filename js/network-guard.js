/**
 * Each page's network guard (#21 slice 1b, "Guard"): the first script of newtab.html,
 * popup.html, sidepanel.html, and offscreen.html, ahead of every other, the new tab's boot
 * guard and the libraries the loader puts in included. The build bundles it into a classic
 * script at this path with the destination registry inlined (CLASSIC_SCRIPTS' 'bundle' in
 * scripts/build/vite-config.js), so the page is guarded before its next script runs. It never
 * throws, so a page it can't guard still starts, or shows that it couldn't.
 */

import './kernel/composition/network-guard-first.js';
