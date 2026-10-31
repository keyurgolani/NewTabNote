/**
 * The workspace chunk (js/workspace.js), as the strict projects see it: the boot root reaches the
 * legacy files only through this, so none of them enters a strict program (#27, "Type gate")
 */

/**
 * Start the new tab with the page's loader (js/main.js)
 * @param loader - js/runtime/lazy.js's pageLoader()
 */
export function boot(loader: unknown): Promise<void> | null;
