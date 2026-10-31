/**
 * recovery.html's entry (#20 slice 4b): the Trust Center and the Recovery Center, drawn by
 * js/trust/ui/view.js on the page's own root (js/kernel/composition/recovery.js), which serves
 * the trust operations in this page. The worker serves none of them, and nothing here is in
 * the new tab's start path: the page is its own entry.
 */

// storage.js puts Storage on window, where the root's legacy adapter finds it
import './storage.js';
import { browserRecoveryLinks, createRecoveryRoot } from './kernel/composition/recovery.js';
import { mountRecoveryPage } from './trust/ui/view.js';

mountRecoveryPage({
  document,
  root: createRecoveryRoot(),
  location: window.location,
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  ...browserRecoveryLinks(),
  reload: () => window.location.reload(),
});
