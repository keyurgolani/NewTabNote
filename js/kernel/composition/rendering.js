/**
 * The trusted-rendering port for the new tab's legacy scripts (#14 slice 2), as
 * `BlockRendering`: blocks.js, the editor and the formatting toolbar render rich text, take it
 * in, and escape plain text into it through this object, and through no other `innerHTML`
 * (test/render-sinks.test.js and security/render-sinks.json). js/main.js imports it with the
 * block projections, before any of them.
 *
 * This is the one place the implementation is chosen: today the legacy adapter, which keeps
 * 1.4.x's markup; #21 slice 2 puts its sanitizer here. The unit tests give the legacy scripts
 * the same global through test/helpers/legacy-env.js and test/helpers/block-rendering.js.
 */

import { legacyRendering } from '../adapters/rendering/legacy.js';

/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis)).BlockRendering = legacyRendering();
