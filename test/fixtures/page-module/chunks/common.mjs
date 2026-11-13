// The module both chunks import and the page doesn't. Its imports go two deep, so a load that
// starts while the other chunk's is linking it finds it half linked.
import { evaluated } from '../shared.mjs';
import { deep } from './deep.mjs';

evaluated.push('common');
export const common = { deep };
