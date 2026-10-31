/**
 * The block projections for the new tab's legacy scripts (#14 slice 1). SidebarUtils, the
 * editor, AI chat, NotesManager, AIResponseUtils, and the settings export read a block's text
 * and Markdown through `BlockProjections`, which this module sets from the built-ins' catalog,
 * so they run the same projections and codec the kernel does. They strip tags through it too,
 * with the model layer's `stripTags` and `replaceTags`, and the editor's save reads its wiki-link
 * names with `wikiLinkNames`, the note domain's, all in linear time. js/main.js imports it
 * before any of them.
 *
 * The catalog runs the block contract's checks as it's made, so an invalid built-in is
 * disabled at start here too. Registering the `block` family on #15's kit
 * (js/kernel/composition/blocks.js) adds the kit's own checks and the block-health query; the
 * root that first reads that query (the Trust Center's, for #20's block-types provider)
 * registers it, so the new tab's start doesn't load the kit for nothing. Both give the same
 * projections (test/blocks-characterization.test.js).
 *
 * The legacy scripts can't import a module, and read no fallback (the bundle holds no
 * `require`): the unit tests give them the same global, through test/helpers/legacy-env.js and
 * test/helpers/block-projections.js.
 */

import { builtInCatalog, pageReaders } from '../core/blocks/index.js';

/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis)).BlockProjections = pageReaders(builtInCatalog());
