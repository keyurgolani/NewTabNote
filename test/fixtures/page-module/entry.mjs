// test/page-module.test.js's page: it imports shared.mjs statically and loads its chunks, beside
// it and under chunks/, through import(), as a page loads its chunks
import { evaluated } from './shared.mjs';

export { evaluated };
export const loadLazy = () => import('./lazy.mjs');
export const loadOuter = () => import('./outer.mjs');
export const loadShared = () => import('./shared.mjs');
export const loadBare = () => import('node:path');
export const loadLeft = () => import('./chunks/left.mjs');
export const loadRight = () => import('./chunks/right.mjs');
export const loadCommon = () => import('./chunks/common.mjs');
export const loadBroken = () => import('./chunks/broken.mjs');
