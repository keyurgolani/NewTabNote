/**
 * applyCloseDraft for Popup's and Side Panel's tables (handlers.js): its handler, loaded from the
 * `close-drafts-chunk` chunk at its first use (#33, the lead's option 1), so their start loads
 * none of it. The kernel awaits a handler's promise, and those pages send the command only once
 * their root has loaded the same chunk to apply the page's drafts (composition/close-drafts.js).
 */

/** @type {import('./work.js').CommandHandler<'applyCloseDraft'>} */
export const applyCloseDraftOnDemand = (command, context) =>
  import('./close-drafts-chunk.js').then(chunk => chunk.closeDraftCommands.applyCloseDraft(command, context));
