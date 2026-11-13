// The chunk entry.mjs loads through import(), on the shared.mjs entry.mjs imports statically
import { evaluated } from './shared.mjs';

evaluated.push('lazy');

export const answer = 42;
export { evaluated };
