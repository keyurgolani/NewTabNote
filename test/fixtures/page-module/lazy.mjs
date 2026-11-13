// The chunk entry.mjs loads through import(), on the shared.mjs entry.mjs imports statically. It
// awaits at its top level, so its exports are there only once its evaluation is done.
import { evaluated } from './shared.mjs';

evaluated.push('lazy');
for (let turn = 0; turn < 20; turn += 1) await null;

export const answer = 42;
export { evaluated };
