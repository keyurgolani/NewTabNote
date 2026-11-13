// One of two chunks the page loads at once, on common.mjs, which the page hasn't loaded. It loads
// its sibling through an import() of its own, which resolves beside it, not beside the page.
import { common } from './common.mjs';

export { common };
export const loadSibling = () => import('./sibling.mjs');
