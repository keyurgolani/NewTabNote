// test/page-module.test.js's page: it imports shared.mjs statically and loads its chunk,
// lazy.mjs, through import(), as a page loads its chunks
import { evaluated } from './shared.mjs';

export { evaluated };
export const loadLazy = () => import('./lazy.mjs');
export const loadShared = () => import('./shared.mjs');
export const loadBare = () => import('node:path');
