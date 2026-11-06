/**
 * recovery.html's table (handlers.js): the one query its root sends, its theme (#20 slice 4b).
 * Its Trust Center and Recovery Center run on the page's own trust router, which no kernel
 * table holds (js/kernel/composition/recovery.js), and it sends no note command, so it applies
 * no closing tab's edit and journals nothing.
 */

import { handlerTable } from './handlers.js';
import { preferenceQueries } from './preferences.js';

export const RECOVERY_HANDLERS = handlerTable({ queries: { getPreferences: preferenceQueries.getPreferences } });
