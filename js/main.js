/**
 * ES module entry point for New Tab Note.
 *
 * Each source file is loaded as a side-effect import. The files set up
 * their globals (window.Utils, window.Storage, etc.) when they execute.
 * This single entry point replaces the individual <script> tags that
 * were previously listed in newtab.html.
 *
 * Vendored libraries (fuse.js, jszip, chart.js, transformers.js) are
 * loaded via regular <script> tags before this module, since they are
 * not ES modules.
 */

// Core infrastructure
import './utils.js';
import './core/storage-error.js';
import './core/event-bus.js';
import './core/dom-refs.js';
import './core/logger.js';

// Utils
import './utils/sanitize.js';
import './ui/confirm-dialog.js';
import './ui/formatting-toolbar.js';
import './ui/graph-view.js';

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

// App (includes DOMContentLoaded listener that initializes everything)
import './app.js';
