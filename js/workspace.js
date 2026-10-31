/**
 * The workspace chunk's module (#27 slice 3, "Entries"): today's whole new tab, the legacy graph
 * js/main.js imports, which the boot root (js/entries/newtab.js) loads through the page's
 * loader and starts with boot(). The chunk takes its name from this file, and build-info.json's
 * chunks names it so, which the loader's retry reads. js/workspace.d.ts declares it for the
 * strict projects, so no legacy file enters them.
 */

export { boot } from './main.js';
