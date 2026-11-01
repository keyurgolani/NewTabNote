/**
 * The new tab's legacy graph, which the workspace chunk holds (js/workspace.js, #27 slice 3).
 *
 * Each source file is loaded as a side-effect import. The files set up
 * their globals (window.Utils, window.Storage, etc.) when they execute.
 * This graph replaces the individual <script> tags that were previously
 * listed in newtab.html. boot() then has the new tab's composition root
 * (#12) start App.
 *
 * The vendored libraries (fuse.js, jszip, chart.js, transformers.js) aren't
 * ES modules, and none loads with the page: each loads as a classic script
 * at its first use, through the page's loader (js/runtime/lazy.js).
 */

// The block projections the legacy scripts read blocks through (#14), and the trusted-rendering
// port they render rich text through (#14 slice 2), before any of them
import './kernel/composition/block-projections.js';
import './kernel/composition/rendering.js';

// Core infrastructure
import './utils.js';
import './core/storage-error.js';
import './core/dom-refs.js';
import './core/logger.js';

// Utils
import './utils/sanitize.js';
import './ui/confirm-dialog.js';
import './ui/formatting-toolbar.js';
import './ui/graph-view.js';
import './ui/export-notice.js';
import './ui/part-state.js';

// Data & Services
import './storage.js';
import './theme-engine.js';
import './virtual-scroller.js';
import './block-placeholders.js';
import './resizable-panel.js';
import './sidebar-utils.js';
import './shortcut-utils.js';
import './command-palette-utils.js';
import './ai-prompt-templates.js';
import './ai-response-utils.js';
import './search.js';
import './image-compression.js';
import './blocks.js';
import './editor.js';
import './llm.js';
import './analytics.js';
import './embeddings.js';
import './onboarding.js';

// Services
import './services/sync-service.js';

// Premium chat UI components
import './stream-renderer.js';
import './scroll-state-machine.js';
import './chat-ui-components.js';

// Controllers
import './controllers/sidebar-controller.js';
import './controllers/tab-controller.js';
import './controllers/ai-chat-controller.js';
import './controllers/settings-controller.js';
import './controllers/theme-builder-controller.js';
import './controllers/analytics-controller.js';
import './controllers/notes-manager.js';
import './controllers/shortcuts-manager.js';
import './controllers/export-import-service.js';

// App, which the new tab's composition root constructs with the tab's kernel and starts
import './app.js';
import { startNewTab } from './kernel/composition/newtab.js';

/**
 * Start the new tab with the page's loader: the boot root (js/entries/newtab.js) calls it once
 * it has loaded this graph as the workspace chunk. js/workspace.d.ts declares it for the strict
 * projects.
 * @param {unknown} [loader] - js/runtime/lazy.js's pageLoader()
 * @returns {Promise<void> | null}
 */
export function boot(loader) {
  return startNewTab({ loader });
}
